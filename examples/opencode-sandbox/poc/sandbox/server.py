import json
import os

import anthropic
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()
client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

# Per-pod in-memory history — one sandbox = one session
history: list[dict] = []


class MessageRequest(BaseModel):
    text: str


@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.post("/message")
def message(req: MessageRequest):
    history.append({"role": "user", "content": req.text})

    def generate():
        full = ""
        with client.messages.stream(
            model="claude-sonnet-4-6",
            max_tokens=8096,
            system="You are a coding assistant. Help the user with coding tasks.",
            messages=history,
        ) as stream:
            for text in stream.text_stream:
                full += text
                yield f"data: {json.dumps({'delta': text})}\n\n"
        history.append({"role": "assistant", "content": full})
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
