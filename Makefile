.PHONY: init init-full up up-full up-compose down down-full down-compose logs status test-isolation build build-image test clean destroy

HONORCLAW_VERSION ?= latest
IMAGE_NAME ?= honorclaw
IMAGE_TAG ?= $(IMAGE_NAME):$(HONORCLAW_VERSION)

# Development
build:
	pnpm build

test:
	pnpm test

clean:
	pnpm clean

dev:
	pnpm dev

# Docker image build
build-image:
	docker build -t $(IMAGE_TAG) -f infra/docker/honorclaw.Dockerfile .

# Tier 1 — Single Container
init:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "JWT_SECRET=$$(openssl rand -base64 48)" >> .env; \
		echo "SESSION_COOKIE_SECRET=$$(openssl rand -base64 32)" >> .env; \
		echo "HONORCLAW_MASTER_KEY=$$(openssl rand -base64 32)" >> .env; \
		echo "POSTGRES_PASSWORD=$$(openssl rand -base64 16)" >> .env; \
		echo "REDIS_PASSWORD=$$(openssl rand -base64 16)" >> .env; \
		echo "Created .env with generated secrets"; \
	fi
	$(MAKE) build-image
	docker compose -f infra/docker/docker-compose.yml up -d
	@echo "HonorClaw initialized. Run 'make up' or access http://localhost:3000"

init-full:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "JWT_SECRET=$$(openssl rand -base64 48)" >> .env; \
		echo "SESSION_COOKIE_SECRET=$$(openssl rand -base64 32)" >> .env; \
		echo "HONORCLAW_MASTER_KEY=$$(openssl rand -base64 32)" >> .env; \
		echo "POSTGRES_PASSWORD=$$(openssl rand -base64 16)" >> .env; \
		echo "REDIS_PASSWORD=$$(openssl rand -base64 16)" >> .env; \
		echo "Created .env with generated secrets"; \
	fi
	$(MAKE) build-image
	docker compose -f infra/docker/docker-compose.security-full.yml up -d
	@echo "HonorClaw initialized (full security). Run 'make up-full' or access http://localhost:3000"

up: build-image
	docker run -d --name honorclaw \
		-p 3000:3000 \
		-v honorclaw-data:/data \
		-v /var/run/docker.sock:/var/run/docker.sock \
		--cap-add SYS_ADMIN \
		--cap-add NET_ADMIN \
		$(IMAGE_TAG)

up-compose:
	docker compose -f infra/docker/docker-compose.yml up -d --build

up-full:
	docker compose -f infra/docker/docker-compose.security-full.yml up -d

down:
	@docker stop honorclaw 2>/dev/null; docker rm honorclaw 2>/dev/null || true

down-compose:
	docker compose -f infra/docker/docker-compose.yml down

down-full:
	docker compose -f infra/docker/docker-compose.security-full.yml down

logs:
	docker logs -f honorclaw

status:
	@docker inspect honorclaw --format "Status: {{.State.Status}}" 2>/dev/null || echo "Not running"
	@curl -sf http://localhost:3000/health/ready 2>/dev/null && echo " Control plane: healthy" || echo " Control plane: not reachable"

test-isolation:
	scripts/test-network-isolation.sh

destroy:
	@read -p "Delete all data? (y/N) " r; [ "$$r" = "y" ] && docker volume rm honorclaw-data || echo "Cancelled"
