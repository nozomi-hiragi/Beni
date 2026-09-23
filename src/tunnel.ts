import { BeniError } from "./types.ts";

export function startTunnel() {
  const token = process.env.BENI_CLOUDFLARE_TUNNEL_TOKEN?.trim();
  if (!token) throw new BeniError("tunnel_token", ".envにBENI_CLOUDFLARE_TUNNEL_TOKENを設定してください。");
  if (!Bun.which("cloudflared")) throw new BeniError("tunnel_binary", "cloudflaredをインストールしてください。");
  // Use the documented environment variable so the token is absent from argv.
  // Do not pass application credentials to the tunnel or expose raw process logs.
  const child = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "run"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TUNNEL_TOKEN: token },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  return child;
}
