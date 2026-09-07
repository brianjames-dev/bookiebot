(() => {
  const status = document.getElementById("setup-status");
  const button = document.getElementById("connect-phone");
  const token = location.hash.slice(1);
  // Keep the fragment until connection succeeds so Discord's Open in Safari
  // handoff retains the setup link. Fragments never enter server request logs.
  let pending = false;
  async function request(path) {
    const response = await fetch(path, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-BookieBot-App": "1" },
      body: JSON.stringify({ token }), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not connect. Please try again.");
    return data;
  }
  if (!token) {
    status.textContent = "Request /expense_app in Discord, then open your private setup link in Safari.";
    return;
  }
  request("/app/pairing").then((data) => {
    status.textContent = `Connect this iPhone to ${data.ownerName}’s expense report.`;
    button.textContent = `Connect as ${data.ownerName}`;
    button.hidden = false;
  }).catch((error) => { status.textContent = error.name === "TimeoutError" ? "Setup took too long. Reopen your link in Safari and try again." : error.message; });
  button.addEventListener("click", async () => {
    if (pending) return;
    pending = true;
    button.disabled = true;
    status.textContent = "Connecting your phone…";
    try {
      await request("/app/connect");
      location.replace("/app/expenses");
    } catch (error) {
      status.textContent = "Could not finish connecting. Open BookieBot to check, or request a new /expense_app link in Discord.";
      const link = document.createElement("a");
      link.href = "/app/expenses";
      link.textContent = " Open BookieBot";
      status.append(link);
      button.hidden = true;
    }
  });
})();
