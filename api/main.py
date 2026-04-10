from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import hierarchy, requirement_links, requirements, saved_filters
from routers.source_documents import ensure_bucket
from routers.attachments import ensure_attachments_bucket
import routers.source_documents as source_documents
import routers.attachments as attachments
import routers.conflict_records as conflict_records
import routers.extraction as extraction
import routers.document_references as document_references
import routers.reports as reports
import routers.search as search
import routers.export as export_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create MinIO buckets on startup — like a migration for object storage.
    for ensure_fn in (ensure_bucket, ensure_attachments_bucket):
        try:
            ensure_fn()
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
app.include_router(attachments.router, prefix="/api", tags=["attachments"])
app.include_router(saved_filters.router, prefix="/api", tags=["saved-filters"])
app.include_router(conflict_records.router, prefix="/api", tags=["conflict-records"])
app.include_router(extraction.router, prefix="/api", tags=["extraction"])
app.include_router(document_references.router, prefix="/api", tags=["document-references"])
app.include_router(reports.router, prefix="/api", tags=["reports"])
app.include_router(search.router, prefix="/api", tags=["search"])
app.include_router(export_router.router, prefix="/api", tags=["export"])


@app.get("/health")
def health_check():
    return {"status": "ok"}
