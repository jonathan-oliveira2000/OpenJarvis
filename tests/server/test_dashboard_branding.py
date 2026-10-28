from openjarvis.server.comparison import COMPARISON_HTML
from openjarvis.server.dashboard import DASHBOARD_HTML


def test_savings_dashboard_uses_mega_identity() -> None:
    assert "<title>M.E.G.A. — Savings Dashboard</title>" in DASHBOARD_HTML
    assert "<h1><span>M.E.G.A.</span> Savings Dashboard</h1>" in DASHBOARD_HTML
    assert "OpenJarvis" not in DASHBOARD_HTML


def test_cost_comparison_uses_mega_identity_and_keeps_upstream_command() -> None:
    assert "<title>M.E.G.A. — Cost Comparison</title>" in COMPARISON_HTML
    assert "<h1><span>M.E.G.A.</span> Cost Comparison</h1>" in COMPARISON_HTML
    assert "<th>M.E.G.A. (Local)</th>" in COMPARISON_HTML
    assert "git clone https://github.com/open-jarvis/OpenJarvis.git" in COMPARISON_HTML
