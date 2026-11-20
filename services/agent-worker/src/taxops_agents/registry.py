from __future__ import annotations

from .contract import Agent


class AgentRegistry:
    """Maps events to agents. Adding an agent = registering it here; nothing else in the platform changes."""

    def __init__(self) -> None:
        self._agents: dict[str, type[Agent]] = {}

    def register(self, agent_cls: type[Agent]) -> type[Agent]:
        spec = getattr(agent_cls, "spec", None)
        if spec is None:
            raise TypeError(f"{agent_cls.__name__} must define a class-level `spec`.")
        if not hasattr(agent_cls, "input_model") or not hasattr(agent_cls, "output_model"):
            raise TypeError(f"{agent_cls.__name__} must define `input_model` and `output_model`.")
        if spec.name in self._agents:
            raise ValueError(f"An agent named {spec.name!r} is already registered.")
        self._agents[spec.name] = agent_cls
        return agent_cls

    def get(self, name: str) -> type[Agent]:
        try:
            return self._agents[name]
        except KeyError:
            raise KeyError(f"No agent registered with name {name!r}.") from None

    def for_event(self, event: str) -> list[type[Agent]]:
        return [a for a in self._agents.values() if event in a.spec.triggers]

    def events(self) -> list[str]:
        """Every event type at least one agent listens to (what the worker asks the queue for)."""
        return sorted({e for a in self._agents.values() for e in a.spec.triggers})

    def names(self) -> list[str]:
        return sorted(self._agents)
