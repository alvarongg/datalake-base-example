import os

# jsii se niega a usar su caché si el HOME es escribible por el grupo (típico en contenedores).
os.environ.setdefault("JSII_RUNTIME_PACKAGE_CACHE", "disabled")
os.environ.setdefault("JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION", "1")
