.PHONY: up down build seed logs clean

up:
	docker compose up

down:
	docker compose down

build:
	docker compose build

seed:
	docker compose exec api python scripts/seed_hierarchy.py

logs:
	docker compose logs -f

# WARNING: 'make clean' removes all volumes including the database.
clean:
	docker compose down -v
