#!/bin/bash
# ─────────────────────────────────────────────────────────────
# AWS Deployment Script
# Deploys perf-agent as a Docker container on AWS ECS Fargate.
# Prerequisites: AWS CLI configured, ECR repo, ECS cluster.
# ─────────────────────────────────────────────────────────────

set -e

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="perf-agent"
ECS_CLUSTER="perf-agent-cluster"
ECS_SERVICE="perf-agent-service"
IMAGE_TAG=$(git rev-parse --short HEAD 2>/dev/null || echo "latest")
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"

echo "=== perf-agent AWS Deployment ==="
echo "Region:   $AWS_REGION"
echo "Account:  $AWS_ACCOUNT_ID"
echo "Tag:      $IMAGE_TAG"

# 1. Build TypeScript
echo "Building TypeScript..."
npm run build

# 2. Build and push Docker image to ECR
echo "Logging into ECR..."
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Create ECR repo if it doesn't exist
aws ecr describe-repositories --repository-names $ECR_REPO --region $AWS_REGION 2>/dev/null || \
  aws ecr create-repository --repository-name $ECR_REPO --region $AWS_REGION

echo "Building Docker image..."
docker build -t $ECR_REPO:$IMAGE_TAG .
docker tag $ECR_REPO:$IMAGE_TAG $ECR_URI:$IMAGE_TAG
docker tag $ECR_REPO:$IMAGE_TAG $ECR_URI:latest

echo "Pushing to ECR..."
docker push $ECR_URI:$IMAGE_TAG
docker push $ECR_URI:latest

# 3. Update ECS service (assumes task definition and service already exist)
echo "Updating ECS service..."
aws ecs update-service \
  --cluster $ECS_CLUSTER \
  --service $ECS_SERVICE \
  --force-new-deployment \
  --region $AWS_REGION

echo "=== Deployment complete ==="
echo "Image: $ECR_URI:$IMAGE_TAG"
echo "Monitor: https://console.aws.amazon.com/ecs/home?region=${AWS_REGION}#/clusters/${ECS_CLUSTER}"
