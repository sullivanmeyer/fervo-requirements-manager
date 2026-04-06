from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import hierarchy, requirements

app = FastAPI(title="Requirements Management API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(hierarchy.router, prefix="/api", tags=["hierarchy"])
app.include_router(requirements.router, prefix="/api", tags=["requirements"])


@app.get("/health")
def health_check():
    return {"status": "ok"}
