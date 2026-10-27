"""Load the workout log exported from Google Sheets and summarize progression.

Usage:
    uv run main.py data/log.csv
    uv run main.py "https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<LOG_GID>"

The URL form needs the sheet to be readable without login (see README).
"""

import sys

import pandas as pd

KG_PER_LB = 0.45359237


def load_log(source: str) -> pd.DataFrame:
    """One row per set, typed, with derived columns weight_lb, volume_lb, e1rm_lb."""
    df = pd.read_csv(source, dtype={"set_id": str, "session_id": str, "notes": str})
    df["session_date"] = pd.to_datetime(df["session_date"])
    df["logged_at"] = pd.to_datetime(df["logged_at"])
    for col in ["set_number", "weight", "reps", "rpe"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df["weight_lb"] = df["weight"].where(df["unit"] != "kg", df["weight"] / KG_PER_LB)
    df["volume_lb"] = df["weight_lb"] * df["reps"]
    # Epley estimated 1RM; unreliable past ~12 reps, so leave those blank.
    df["e1rm_lb"] = (df["weight_lb"] * (1 + df["reps"] / 30)).where(df["reps"] <= 12)
    return df.sort_values(["session_date", "logged_at"]).reset_index(drop=True)


def progression(df: pd.DataFrame) -> pd.DataFrame:
    """Per exercise per session: sets, top weight, best e1RM, total volume."""
    return (
        df.groupby(["exercise", "session_date"])
        .agg(
            sets=("reps", "size"),
            top_weight_lb=("weight_lb", "max"),
            best_e1rm_lb=("e1rm_lb", "max"),
            volume_lb=("volume_lb", "sum"),
        )
        .round(1)
        .reset_index()
    )


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    df = load_log(sys.argv[1])
    prog = progression(df)
    print(f"{len(df)} sets across {df['session_id'].nunique()} sessions\n")
    for exercise, g in prog.groupby("exercise"):
        print(f"== {exercise}")
        print(g.drop(columns="exercise").tail(8).to_string(index=False), end="\n\n")


if __name__ == "__main__":
    main()
