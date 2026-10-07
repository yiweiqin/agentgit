from ..delta.model import Prediction


def predict(a, b):
    entities = ["file:" + p for p in sorted(set(a.files) & set(b.files))]
    return Prediction(
        "conflicting" if entities else "independent",
        entities[:3],
        float(bool(entities)),
        ["File overlap"],
    )
