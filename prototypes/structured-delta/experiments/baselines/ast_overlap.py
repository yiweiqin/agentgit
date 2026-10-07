from ..delta.model import Prediction


def predict(a, b, mode="symbol"):
    if mode == "line":
        entities = [
            f"file:{p}"
            for p in sorted(set(a.files) & set(b.files))
            if set(a.lines[p]) & set(b.lines[p])
        ]
    else:
        entities = sorted(set(a.symbols) & set(b.symbols))
    return Prediction(
        "conflicting" if entities else "independent",
        entities[:3],
        float(bool(entities)),
        [mode + " overlap"],
    )
