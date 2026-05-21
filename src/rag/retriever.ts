import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { RunbookChunk, RetrievedContext } from '../types';
import { logger } from '../utils/logger';
import { v4 as uuid } from 'uuid';

// ─────────────────────────────────────────────────────────────
// RAG RETRIEVER
//
// Hybrid implementation:
//   - Production: Pinecone vector DB (set PINECONE_API_KEY + PINECONE_INDEX)
//   - Development: in-memory cosine similarity (no setup needed)
//
// Embedding provider: OpenAI text-embedding-3-small (cheap, fast, 1536 dim)
//   - Fallback to deterministic hash-based pseudo-embedding for local-only dev
// ─────────────────────────────────────────────────────────────

const EMBEDDING_DIM   = 1536;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const PINECONE_INDEX  = process.env.PINECONE_INDEX || 'perfagent-runbooks';

// In-memory store for dev mode
interface InMemoryEntry {
  chunk: RunbookChunk;
  vector: number[];
}
const memoryStore: InMemoryEntry[] = [];

let pinecone: Pinecone | null = null;
let openai:   OpenAI | null = null;

function initClients() {
  if (process.env.PINECONE_API_KEY && !pinecone) {
    pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    logger.info('Pinecone client initialized');
  }
  if (process.env.OPENAI_API_KEY && !openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    logger.info('OpenAI embedding client initialized');
  }
}

// ── Generate embedding for text ──────────────────────────────

async function embed(text: string): Promise<number[]> {
  initClients();

  if (openai) {
    try {
      const r = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000),    // OpenAI limit
      });
      return r.data[0].embedding;
    } catch (err) {
      logger.warn('OpenAI embedding failed, using fallback hash:', err);
    }
  }

  // Deterministic pseudo-embedding for fully local dev
  // Not as good as real embeddings, but enables RAG flow testing
  return pseudoEmbed(text);
}

function pseudoEmbed(text: string): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  const words = text.toLowerCase().split(/\s+/).slice(0, 200);
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i++) {
      h = ((h << 5) - h) + w.charCodeAt(i);
      h |= 0;
    }
    const idx = Math.abs(h) % EMBEDDING_DIM;
    v[idx] += 1;
  }
  // L2 normalize
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ── Ingest a runbook / postmortem / doc ──────────────────────

export async function ingestDocument(
  source: string,
  title: string,
  content: string,
  category: RunbookChunk['category'] = 'runbook',
  tags: string[] = []
): Promise<RunbookChunk[]> {
  initClients();

  // Chunk the content — 800 chars per chunk with 100 char overlap
  const chunks: RunbookChunk[] = [];
  const CHUNK_SIZE = 800;
  const OVERLAP    = 100;

  for (let i = 0; i < content.length; i += (CHUNK_SIZE - OVERLAP)) {
    const text = content.slice(i, i + CHUNK_SIZE);
    if (text.trim().length < 50) continue;   // skip tiny fragments

    chunks.push({
      id:        uuid(),
      source,
      title:     chunks.length === 0 ? title : `${title} (part ${chunks.length + 1})`,
      content:   text,
      category,
      tags,
      createdAt: new Date(),
    });
  }

  logger.info(`Ingesting ${chunks.length} chunks from "${source}" (${category})`);

  // Embed all chunks
  const embeddings = await Promise.all(chunks.map(c => embed(c.content)));

  // Store in Pinecone OR in-memory
  if (pinecone) {
    try {
      const index = pinecone.index(PINECONE_INDEX);
      await index.upsert(
        chunks.map((chunk, i) => ({
          id: chunk.id,
          values: embeddings[i],
          metadata: {
            source: chunk.source,
            title: chunk.title,
            content: chunk.content.slice(0, 4000),  // Pinecone metadata limit
            category: chunk.category,
            tags: chunk.tags,
          },
        }))
      );
      logger.info(`Upserted ${chunks.length} chunks to Pinecone`);
    } catch (err) {
      logger.error('Pinecone upsert failed, falling back to memory:', err);
      chunks.forEach((chunk, i) => memoryStore.push({ chunk, vector: embeddings[i] }));
    }
  } else {
    chunks.forEach((chunk, i) => memoryStore.push({ chunk, vector: embeddings[i] }));
    logger.info(`Stored ${chunks.length} chunks in memory (no Pinecone configured)`);
  }

  return chunks;
}

// ── Retrieve top-K most relevant chunks for a query ──────────

export async function retrieveContext(
  query: string,
  topK: number = 3,
  filter?: { category?: string; tags?: string[] }
): Promise<RetrievedContext> {
  initClients();
  const start = Date.now();

  const queryVec = await embed(query);
  let chunks: RunbookChunk[] = [];

  if (pinecone) {
    try {
      const index = pinecone.index(PINECONE_INDEX);
      const queryFilter: any = {};
      if (filter?.category) queryFilter.category = { $eq: filter.category };

      const result = await index.query({
        vector: queryVec,
        topK,
        includeMetadata: true,
        ...(Object.keys(queryFilter).length && { filter: queryFilter }),
      });

      chunks = (result.matches || []).map(m => ({
        id:        m.id,
        source:    (m.metadata?.source as string) || '',
        title:     (m.metadata?.title as string) || '',
        content:   (m.metadata?.content as string) || '',
        category:  (m.metadata?.category as RunbookChunk['category']) || 'runbook',
        tags:      (m.metadata?.tags as string[]) || [],
        createdAt: new Date(),
      }));
    } catch (err) {
      logger.error('Pinecone query failed, falling back to memory:', err);
    }
  }

  if (chunks.length === 0 && memoryStore.length > 0) {
    // In-memory cosine similarity search
    const filtered = filter?.category
      ? memoryStore.filter(e => e.chunk.category === filter.category)
      : memoryStore;

    const scored = filtered.map(e => ({
      chunk: e.chunk,
      score: cosineSimilarity(queryVec, e.vector),
    }));

    scored.sort((a, b) => b.score - a.score);
    chunks = scored.slice(0, topK).map(s => s.chunk);
  }

  const latencyMs = Date.now() - start;
  logger.info(`Retrieved ${chunks.length} chunks for query "${query.slice(0, 50)}..." in ${latencyMs}ms`);

  return {
    chunks,
    query,
    retrievedAt: new Date(),
    latencyMs,
  };
}

// ── Format retrieved context for injection into prompts ─────

export function formatContextForPrompt(ctx: RetrievedContext): string {
  if (ctx.chunks.length === 0) return '';

  return `\n\nRELEVANT RUNBOOKS AND PAST INCIDENTS (use as additional context):\n\n` +
    ctx.chunks.map((c, i) =>
      `[Source ${i + 1}: ${c.title} (${c.category})]\n${c.content}\n`
    ).join('\n---\n');
}

// ── Stats for observability ──────────────────────────────────

export function getRagStats() {
  return {
    backend: pinecone ? 'pinecone' : 'in-memory',
    memoryEntries: memoryStore.length,
    embeddingModel: openai ? EMBEDDING_MODEL : 'pseudo-hash',
  };
}
