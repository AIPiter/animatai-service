"""
SSE (Server-Sent Events) endpoint for real-time project status updates.
Frontend connects to /api/events/{project_id} and receives updates
pushed from worker services via Redis pub/sub.
"""

import asyncio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from .. import db
from ..messaging.status_listener import subscribe, unsubscribe

router = APIRouter(prefix="/api/events", tags=["events"])
HEARTBEAT_INTERVAL = 15  # seconds


@router.get("/{project_id}")
async def project_events(project_id: str, request: Request):
    project = await db.get_project(project_id)
    if not project or str(project["user_id"]) != request.state.user_id:
        raise HTTPException(404, "Project not found")

    async def stream():
        q = await subscribe(project_id)
        try:
            while True:
                # Wait for event or heartbeat timeout
                try:
                    message = await asyncio.wait_for(q.get(), timeout=HEARTBEAT_INTERVAL)
                    yield f"data: {message}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"   # SSE comment — keeps connection alive

                # Stop if client disconnected
                if await request.is_disconnected():
                    break
        finally:
            unsubscribe(project_id, q)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":               "no-cache",
            "X-Accel-Buffering":           "no",      # disable nginx buffering
            "Access-Control-Allow-Origin": "*",
        },
    )
