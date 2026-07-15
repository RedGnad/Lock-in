import { ImageResponse } from "next/og";

export const alt = "Lock In — accountability that pays";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        padding: "72px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        color: "#10100f",
        background: "#f3efe4",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "22px", fontSize: 30, fontWeight: 900, letterSpacing: "-0.04em" }}>
        <span>LOCK</span><span style={{ color: "#ff4d00" }}>IN</span>
        <span style={{ width: 700, height: 2, background: "#10100f" }} />
        <span style={{ fontSize: 18, letterSpacing: "0.1em" }}>MONAD</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ color: "#ff4d00", fontSize: 27, fontWeight: 800 }}>ACCOUNTABILITY THAT PAYS</span>
        <span style={{ maxWidth: 940, marginTop: 20, fontSize: 104, fontWeight: 950, lineHeight: 0.86, letterSpacing: "-0.08em" }}>YOUR WORD.</span>
        <span style={{ maxWidth: 940, color: "#ff4d00", fontSize: 104, fontWeight: 950, lineHeight: 0.86, letterSpacing: "-0.08em" }}>LOCKED IN.</span>
      </div>
      <div style={{ display: "flex", gap: "42px", fontSize: 18, fontWeight: 800, letterSpacing: "0.06em" }}>
        <span>ONCHAIN STREAKS</span><span>PVP PAYOUTS</span><span>1 USDC MAX</span>
      </div>
    </div>,
    size,
  );
}
