.PHONY: init init-full up up-full up-compose down down-full down-compose logs status test-isolation build test clean destroy

HONORCLAW_VERSION ?= latest
IMAGE_NAME ?= ghcr.io/honorclaw/honorclaw

# Development
build:
	pnpm build

test:
	pnpm test

clean:
	pnpm clean

dev:
	pnpm dev

# Tier 1 — Single Container
init:
	docker run --rm -it -v honorclaw-data:/data $(IMAGE_NAME):$(HONORCLAW_VERSION) init

init-full:
	docker run --rm -it -v honorclaw-data:/data $(IMAGE_NAME):$(HONORCLAW_VERSION) init --security full

up:
	docker run -d --name honorclaw \
		-p 3000:3000 \
		-v honorclaw-data:/data \
		-v /var/run/docker.sock:/var/run/docker.sock \
		--cap-add SYS_ADMIN \
		$(IMAGE_NAME):$(HONORCLAW_VERSION)

up-compose:
	docker compose -f infra/docker/docker-compose.yml up -d --build

up-full:
	docker compose -f infra/docker/docker-compose.security-full.yml up -d

down:
	docker stop honorclaw && docker rm honorclaw

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
