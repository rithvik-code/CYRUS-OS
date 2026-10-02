"""
Risk gating. Deliberately a static, readable table — not a learned classifier.

A black-box "risk model" is its own R&D project and adds a second place
things can silently go wrong. For v1, a human should be able to read this
whole file in 30 seconds and know exactly what requires confirmation.
"""

from dataclasses import dataclass

from .actions import INTENT_SCHEMAS


@dataclass
class RiskDecision:
    requires_confirmation: bool
    risk_level: str
    reason: str


def evaluate(intent_name: str, fields: dict) -> RiskDecision:
    risk = INTENT_SCHEMAS.get(intent_name, {}).get("risk", "high")

    if risk == "low":
        return RiskDecision(False, risk, "Read-only or reversible action.")

    if risk == "medium":
        return RiskDecision(True, risk, "Modifies filesystem state or runs a registered script.")

    # Anything not explicitly "low" or "medium" is treated as high risk and blocked
    # from auto-confirmation entirely — there is currently no "high" action registered
    # on purpose. If you add one later, it must go through a stricter, separate gate,
    # not just a bigger confirmation dialog.
    return RiskDecision(True, "high", "Unclassified or high-risk action — treat with maximum caution.")
