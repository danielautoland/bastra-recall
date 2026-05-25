# bastra-recall — Homebrew formula
#
# Lives in https://github.com/n0mad-ai/homebrew-tap (tap repo, separate).
# Copy this file there as Formula/bastra-recall.rb and adjust the `url`
# / `sha256` once a release tarball is published.
#
# Install via:
#   brew tap n0mad-ai/tap
#   brew install bastra-recall
#   bastra install all
#
# This formula is the head-only build for now. For tagged releases, add a
# `url + sha256` block above the `head` line.

class BastraRecall < Formula
  desc "Persistent teammate memory for AI assistants (Claude, ChatGPT, Cursor)"
  homepage "https://github.com/n0mad-ai/bastra-recall"
  license "MIT"
  head "https://github.com/n0mad-ai/bastra-recall.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install"
    system "npm", "run", "build", "--workspace", "@bastra-recall/daemon"

    libexec.install "packages", "package.json", "package-lock.json"

    # CLI + daemon binaries -> bin shims
    bin.install_symlink libexec/"packages/daemon/dist/cli.js" => "bastra"
    bin.install_symlink libexec/"packages/daemon/dist/index.js" => "bastra-recall"
    bin.install_symlink libexec/"packages/daemon/dist/mcp-forwarder.js" => "bastra-recall-mcp"
    bin.install_symlink libexec/"packages/daemon/dist/hook.js" => "bastra-recall-hook"
    bin.install_symlink libexec/"packages/daemon/dist/session-hook.js" => "bastra-recall-session-hook"
  end

  def caveats
    <<~EOS
      Finish setup with:
        bastra install all

      That registers bastra-recall with every supported AI client
      (Claude Code, Claude Desktop, Cursor) and verifies the install.

      The daemon does not auto-start yet. Either:
        • Run it manually:   bastra-recall &
        • Or use the LaunchAgent plist in ~/Library/LaunchAgents/
          (see distribution/launchagent/ in the repo for a template)

      Vault path: pass --vault, set BASTRA_VAULT_PATH, or let the CLI
      auto-detect from an existing claude.json registration.
    EOS
  end

  test do
    assert_match "bastra", shell_output("#{bin}/bastra --version")
    system bin/"bastra", "doctor"
  end
end
