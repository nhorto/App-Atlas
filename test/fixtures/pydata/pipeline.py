"""Turns the raw exports into the numbers the dashboard shows.

Every format here is named by the call that reads or writes it, which is the whole
point: `to_parquet` says parquet out loud, where `open(out_path, "wb")` says only that
a file was touched.
"""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

RAW = Path("data/raw")


def load_games():
    advanced = pd.read_csv("data/advanced_box_scores.csv")
    traditional = pd.read_csv(RAW / "traditional.csv")
    return advanced.merge(traditional, on="game_id")


def load_settings():
    # The `open` is the site; `json.load` is handed a file that is already open, and
    # counting both would report one file as two.
    with open("config/settings.json", encoding="utf-8") as f:
        return json.load(f)


def load_notes():
    return Path("docs/notes.md").read_text(encoding="utf-8")


def load_manifest(path):
    with path.open("r", encoding="utf-8") as f:
        return f.read()


def publish(frame, model):
    frame.to_csv("out/games.csv", index=False)
    frame.to_parquet("out/games.parquet")
    np.save("out/features.npy", frame.values)
    joblib.dump(model, "out/model.pkl")
    Path("out/summary.txt").write_text("done")
    with open("out/report.html", "w", encoding="utf-8") as f:
        f.write("<h1>ok</h1>")
