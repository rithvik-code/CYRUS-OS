"""
Semantic filename index — v1 scope: filenames + paths, NOT file contents.

Indexing every PDF/code file's full text is a real decision with real cost
(embedding time, storage, staleness as files change) — it's the natural
v2 feature, not something to sneak in here because "why not".

Model: sentence-transformers/all-MiniLM-L6-v2 — free, ~80MB, runs on CPU,
good enough for personal-scale (thousands, not millions, of files).
"""

import os
import sqlite3
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

DB_PATH = Path(__file__).resolve().parent.parent / "cyrus_index.sqlite3"
MODEL_NAME = "all-MiniLM-L6-v2"


class FileIndex:
    def __init__(self, indexed_paths: list[str]):
        self.indexed_paths = [Path(os.path.expanduser(p)) for p in indexed_paths]
        self.model = SentenceTransformer(MODEL_NAME)
        self._init_db()

    def _init_db(self):
        self.conn = sqlite3.connect(DB_PATH)
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                embedding BLOB
            )
            """
        )
        self.conn.commit()

    def rebuild(self) -> int:
        """Walk indexed_paths and (re)embed every filename. Returns count indexed."""
        self.conn.execute("DELETE FROM files")
        count = 0
        rows = []
        for root in self.indexed_paths:
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if path.is_file():
                    rows.append(str(path))

        if not rows:
            self.conn.commit()
            return 0

        # Embed the human-readable label (filename + parent dir), not the raw path,
        # so semantic matches work on words, not directory syntax.
        labels = [f"{p} in {Path(p).parent.name}" for p in rows]
        embeddings = self.model.encode(labels, convert_to_numpy=True, show_progress_bar=False)

        for path, emb in zip(rows, embeddings):
            self.conn.execute(
                "INSERT OR REPLACE INTO files (path, embedding) VALUES (?, ?)",
                (path, emb.astype(np.float32).tobytes()),
            )
            count += 1

        self.conn.commit()
        return count

    def search(self, query: str, top_k: int = 8) -> list[str]:
        cur = self.conn.execute("SELECT path, embedding FROM files")
        rows = cur.fetchall()
        if not rows:
            return []

        query_emb = self.model.encode([query], convert_to_numpy=True)[0]
        paths = []
        scores = []
        for path, emb_blob in rows:
            emb = np.frombuffer(emb_blob, dtype=np.float32)
            score = _cosine_sim(query_emb, emb)
            paths.append(path)
            scores.append(score)

        ranked = sorted(zip(paths, scores), key=lambda x: x[1], reverse=True)
        return [p for p, s in ranked[:top_k] if s > 0.2]


def _cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)
