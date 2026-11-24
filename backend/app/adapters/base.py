from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class AdapterResult:
    success: bool
    channel: str
    simulated: bool
    recipient: str
    summary: str
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


class BaseChannelAdapter(ABC):
    channel_name: str = "unknown"

    @abstractmethod
    def send(
        self,
        recipient: str,
        message: str,
        context: Optional[Dict[str, Any]] = None,
        force_fail: bool = False,
    ) -> AdapterResult:
        raise NotImplementedError