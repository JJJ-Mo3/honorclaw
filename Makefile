.PHONY: init init-full up up-full down down-full logs status test-isolation build build-image test clean destroy run-standalone stop-standalone

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

# ── Environment setup ────────────────────────────────────────────────────
# Generate .env from .env.example with real secrets (avoids duplicate keys)
.env:
	@sed \
		-e "s|^JWT_SECRET=.*|JWT_SECRET=$$(openssl rand -base64 48)|" \
		-e "s|^SESSION_COOKIE_SECRET=.*|SESSION_COOKIE_SECRET=$$(openssl rand -base64 32)|" \
		-e "s|^HONORCLAW_MASTER_KEY=.*|HONORCLAW_MASTER_KEY=$$(openssl rand -base64 32)|" \
		-e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$$(openssl rand -base64 16)|" \
		-e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$$(openssl rand -base64 16)|" \
		.env.example > .env
	@echo "Created .env with generated secrets"

# ── Primary deployment (docker-compose) ──────────────────────────────────
init: .env build-image
	@echo "HonorClaw initialized. Run 'make up' to start, then access http://localhost:3000"

init-full: .env build-image
	@echo "HonorClaw initialized (full security). Run 'make up-full' to start, then access http://localhost:3000"

up:
	docker compose -f infra/docker/docker-compose.yml up -d --build

up-full:
	docker compose -f infra/docker/docker-compose.security-full.yml up -d --build

down:
	docker compose -f infra/docker/docker-compose.yml down

down-full:
	docker compose -f infra/docker/docker-compose.security-full.yml down

logs:
	docker compose -f infra/docker/docker-compose.yml logs -f

status:
	@docker compose -f infra/docker/docker-compose.yml ps 2>/dev/null || echo "Not running"
	@curl -sf http://localhost:3000/health/ready 2>/dev/null && echo " Control plane: healthy" || echo " Control plane: not reachable"

# ── Alternative: standalone single container (no compose) ────────────────
run-standalone: build-image
	docker run -d --name honorclaw \
		-p 3000:3000 \
		-v honorclaw-data:/data \
		-v /var/run/docker.sock:/var/run/docker.sock \
		--cap-add SYS_ADMIN \
		--cap-add NET_ADMIN \
		$(IMAGE_TAG)

stop-standalone:
	@docker stop honorclaw 2>/dev/null; docker rm honorclaw 2>/dev/null || true

# ── Testing & cleanup ───────────────────────────────────────────────────
test-isolation:
	scripts/test-network-isolation.sh

destroy:
	@read -p "Delete all data? (y/N) " r; [ "$$r" = "y" ] && docker volume rm honorclaw-data || echo "Cancelled"
