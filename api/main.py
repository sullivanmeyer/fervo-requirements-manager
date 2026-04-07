from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import hierarchy, requirement_links, requirements, saved_filters
from routers.source_documents import ensure_bucket
import routers.source_documents as source_documents


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create the MinIO "documents" bucket if it doesn't already exist.
    # This runs once when the API container starts, so we never have to
    # create it manually — think of it like a database migration for storage.
    try:
        ensure_bucket()
    except Exception as e:
        print(f"Warning: could not ensure MinIO bucket on startup: {e}")
    yield


app = FastAPI(title="Requirements Management API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(hierarchy.router, prefix="/api", tags=["hierarchy"])
app.include_router(requirements.router, prefix="/api", tags=["requirements"])
app.include_router(requirement_links.router, prefix="/api", tags=["requirement-links"])
app.include_router(source_documents.router, prefix="/api", tags=["source-documents"])
app.include_router(saved_filters.router, prefix="/api", tags=["saved-filters"])


@app.get("/health")
def health_check():
    return {"status": "ok"}
