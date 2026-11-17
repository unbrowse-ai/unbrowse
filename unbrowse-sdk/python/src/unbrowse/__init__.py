"""Python client for the Unbrowse node on your machine: say what you want from a website and get the site's own answer,
and drive the node's browser by hand when a page needs it. ``UnbrowseOwner`` runs the node as its owner; ``wire`` holds
the node's records as they cross the wire, generated from its agent-api.json."""

from . import _generated as wire
from ._generated import OwnerCommands
from .browser import Browser
from .client import (
    DEFAULT_NODE,
    AuthenticationError,
    BadRequestError,
    BrowserMissingError,
    ConflictError,
    NodeConnectionError,
    NodeTimeoutError,
    NodeUnavailableError,
    NotFoundError,
    PaymentRequiredError,
    PermissionDeniedError,
    UnbrowseError,
    UnbrowseNode,
    UnprocessableEntityError,
)

# The familiar name: ``Unbrowse()`` reads UNBROWSE_AGENT_TOKEN and UNBROWSE_NODE, as ``OpenAI()`` reads its key.
Unbrowse = UnbrowseNode
from .models import AnswerField, AnswerFields, BrowseReply, CallResult, Capabilities, Card, Cut, DoResult, JudgeResult, LearnedRoute, LinkPreview, Login, NetworkEntry, NetworkOffers, NetworkSkipped, OfferedEntry, PageAnswer, PagesResult, PaymentRefused, ReportResult, Reputation, Retry, Route, RouteFailure, RouteInput, SkippedEntry, Truncated, Whoami, WrongPage
from .owner import UnbrowseOwner

__version__ = "0.1.0"

__all__ = [
    "Unbrowse",
    "UnbrowseNode",
    "UnbrowseOwner",
    "OwnerCommands",
    "wire",
    "UnbrowseError",
    "BadRequestError",
    "AuthenticationError",
    "PaymentRequiredError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "UnprocessableEntityError",
    "BrowserMissingError",
    "NodeUnavailableError",
    "NodeConnectionError",
    "NodeTimeoutError",
    "Browser",
    "DEFAULT_NODE",
    "Route",
    "RouteInput",
    "CallResult",
    "Cut",
    "Truncated",
    "AnswerField",
    "AnswerFields",
    "Retry",
    "DoResult",
    "PageAnswer",
    "PagesResult",
    "RouteFailure",
    "NetworkEntry",
    "NetworkOffers",
    "NetworkSkipped",
    "OfferedEntry",
    "PaymentRefused",
    "Reputation",
    "SkippedEntry",
    "LearnedRoute",
    "BrowseReply",
    "Whoami",
    "Capabilities",
    "JudgeResult",
    "LinkPreview",
    "WrongPage",
    "ReportResult",
    "Login",
    "Card",
]
