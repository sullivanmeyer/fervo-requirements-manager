"""Storage abstraction layer — MinIO (local dev) or Azure Blob Storage (production).

Switch backends by setting STORAGE_BACKEND=azure in the environment.
All other code in the project imports from this module rather than calling
minio or azure-storage-blob directly, so only this file changes between
the two environments.

MinIO interface (local Docker Compose):
    STORAGE_BACKEND=minio  (default)
    MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY

Azure Blob Storage:
    STORAGE_BACKEND=azure
    AZURE_STORAGE_CONNECTION_STRING
"""

from __future__ import annotations

import io
import os
from typing import Generator

STORAGE_BACKEND: str = os.environ.get("STORAGE_BACKEND", "minio")


class StorageError(Exception):
    """Raised when a file cannot be found or stored."""


# ---------------------------------------------------------------------------
# Backend clients (constructed lazily so unused imports don't break startup)
# ---------------------------------------------------------------------------

def _minio_client():
    from minio import Minio
    endpoint = os.environ.get("MINIO_ENDPOINT", "minio:9000")
    access_key = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
    secret_key = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
    return Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=False)


def _azure_container_client(bucket: str):
    from azure.storage.blob import BlobServiceClient
    conn_str = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
    service = BlobServiceClient.from_connection_string(conn_str)
    return service.get_container_client(bucket)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def ensure_bucket(bucket: str) -> None:
    """Create the bucket / container if it doesn't already exist."""
    if STORAGE_BACKEND == "azure":
        container = _azure_container_client(bucket)
        if not container.exists():
            container.create_container()
    else:
        client = _minio_client()
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)


def upload_file(bucket: str, key: str, data: bytes, content_type: str) -> None:
    """Upload bytes to the given bucket under key."""
    if STORAGE_BACKEND == "azure":
        from azure.storage.blob import ContentSettings
        container = _azure_container_client(bucket)
        container.upload_blob(
            key, data, overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )
    else:
        from minio.error import S3Error
        client = _minio_client()
        try:
            client.put_object(bucket, key, io.BytesIO(data), length=len(data), content_type=content_type)
        except S3Error as e:
            raise StorageError(str(e)) from e


def download_file(bucket: str, key: str) -> Generator[bytes, None, None]:
    """Return a bytes generator suitable for FastAPI StreamingResponse.

    Raises StorageError if the object does not exist.
    The check happens synchronously before any bytes are yielded, so callers
    can wrap this call in a try/except and raise HTTPException before
    returning the StreamingResponse.
    """
    if STORAGE_BACKEND == "azure":
        from azure.core.exceptions import ResourceNotFoundError
        container = _azure_container_client(bucket)
        blob_client = container.get_blob_client(key)
        try:
            stream = blob_client.download_blob()  # raises immediately if missing
        except ResourceNotFoundError:
            raise StorageError(f"File not found: {key}")
        return stream.chunks()
    else:
        from minio.error import S3Error
        client = _minio_client()
        try:
            response = client.get_object(bucket, key)
        except S3Error:
            raise StorageError(f"File not found: {key}")
        return _minio_stream(response)


def read_file(bucket: str, key: str) -> bytes:
    """Read an entire file into memory and return the bytes.

    Used by the LLM extraction pipeline where the full PDF must be passed
    to the model anyway — streaming provides no benefit there.
    Raises StorageError if the object does not exist.
    """
    if STORAGE_BACKEND == "azure":
        from azure.core.exceptions import ResourceNotFoundError
        container = _azure_container_client(bucket)
        blob_client = container.get_blob_client(key)
        try:
            return blob_client.download_blob().readall()
        except ResourceNotFoundError:
            raise StorageError(f"File not found: {key}")
    else:
        from minio.error import S3Error
        client = _minio_client()
        try:
            response = client.get_object(bucket, key)
            return response.read()
        except S3Error:
            raise StorageError(f"File not found: {key}")
        finally:
            try:
                response.close()  # type: ignore[possibly-undefined]
                response.release_conn()  # type: ignore[possibly-undefined]
            except Exception:
                pass


def delete_file(bucket: str, key: str) -> None:
    """Delete a file from storage.  Silently ignores missing files."""
    if STORAGE_BACKEND == "azure":
        from azure.core.exceptions import ResourceNotFoundError
        container = _azure_container_client(bucket)
        try:
            container.get_blob_client(key).delete_blob()
        except ResourceNotFoundError:
            pass
    else:
        client = _minio_client()
        try:
            client.remove_object(bucket, key)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _minio_stream(response) -> Generator[bytes, None, None]:
    """Wrap a MinIO HTTPResponse in a generator that closes the connection."""
    try:
        yield from response
    finally:
        try:
            response.close()
            response.release_conn()
        except Exception:
            pass
