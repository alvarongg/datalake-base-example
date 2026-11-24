#!/usr/bin/env python3
"""Imprime el JSON de entrada del pipeline de datasets (lo usa deplo.sh).

Uso: plan_input.py <dataset|all> [single|with_dependencies]

  all                         -> todos los datasets, en orden de dependencias
  <dataset> single            -> solo ese dataset (falla en Silver si una dependencia no está al día)
  <dataset> with_dependencies -> ese dataset y todo lo que necesita, en orden
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from common.datasets import DATASETS_BY_NAME, all_in_order, dependency_closure  # noqa: E402


def main(argv: list[str]) -> int:
    dataset = argv[1] if len(argv) > 1 else "all"
    mode = argv[2] if len(argv) > 2 else "single"
    if dataset == "all":
        names = all_in_order()
    elif dataset in DATASETS_BY_NAME:
        names = dependency_closure(dataset) if mode == "with_dependencies" else [dataset]
    else:
        print(f"Dataset desconocido: {dataset}. Opciones: all, {', '.join(DATASETS_BY_NAME)}", file=sys.stderr)
        return 2
    print(json.dumps({"datasets": [{"dataset": n, "engine": DATASETS_BY_NAME[n].silver_engine} for n in names]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
