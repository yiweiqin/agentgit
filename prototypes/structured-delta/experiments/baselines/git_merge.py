from ..delta.model import Prediction


def predict(merge_result):
    entities = ["file:" + p for p in merge_result["conflict_paths"]]
    return Prediction(
        "conflicting" if not merge_result["clean"] else "independent",
        entities[:3],
        float(not merge_result["clean"]),
        ["Git merge-tree textual/structural merge"],
    )
