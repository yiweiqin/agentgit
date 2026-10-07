"""Optional two-stage edit-description baseline, based on actual diffs, not gold.

Provider command accepts task='describe' / task='judge', returning description
or label/entities, plus model and usage. Prompts and raw outputs are persisted.
"""

from .embedding import invoke
from ..delta.model import Prediction, LABELS


def predict(command, diff_a, diff_b):
    traces = []
    descriptions = []
    for diff in (diff_a, diff_b):
        request = {
            "task": "describe",
            "instruction": "Describe the behavior of this code edit using only the diff. Identify affected entities as path::symbol or dependency:name. Do not assume unstated intent.",
            "diff": diff,
        }
        response = invoke(command, request)
        if not isinstance(response.get("description"), str):
            raise ValueError("Missing edit description")
        descriptions.append(response["description"])
        traces.append({"request": request, "response": response})
    request = {
        "task": "judge",
        "instruction": "Judge concurrent changes from a common base. Return label: independent, compatible, redundant, or conflicting; and up to 3 interaction entities. Same scope is not sufficient for conflict.",
        "descriptions": descriptions,
    }
    response = invoke(command, request)
    traces.append({"request": request, "response": response})
    if (
        response.get("label") not in LABELS
        or not isinstance(response.get("entities"), list)
        or not all(isinstance(e, str) for e in response["entities"])
    ):
        raise ValueError("Invalid model judgment")
    return Prediction(
        response["label"],
        response["entities"][:3],
        0,
        ["LLM edit descriptions + judgment"],
        {"traces": traces},
    )
