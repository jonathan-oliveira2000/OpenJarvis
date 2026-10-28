from openjarvis.cli._banner import print_banner


def test_banner_uses_mega_identity_and_preserves_tagline(capsys):
    print_banner()

    output = capsys.readouterr().out
    assert "M.E.G.A." in output
    assert "Personal AI, On Personal Devices" in output
    assert "OpenJarvis" not in output


def test_quiet_banner_prints_nothing(capsys):
    print_banner(quiet=True)

    assert capsys.readouterr().out == ""
