# Multi-stage build for GuanLan (观澜) Multi-Agent System
FROM node:20-slim AS runtime

# Install Python and essential system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Install agent-runtime dependencies & build
COPY agent-runtime/package*.json ./agent-runtime/
RUN cd agent-runtime && npm ci

COPY agent-runtime/ ./agent-runtime/
RUN cd agent-runtime && npm run build

# 2. Install Python requirements for MindSpider & Sentiment Analysis
COPY requirements.txt ./
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PATH="/opt/venv/bin:$PATH"

# 3. Copy remaining source code
COPY . .

# Ensure data directories exist
RUN mkdir -p logs final_reports data

EXPOSE 3000

# Default command starts GuanLan Agent Runtime on port 3000
WORKDIR /app/agent-runtime
CMD ["npm", "start"]
