import { ImageResponse } from "next/og";

export const alt =
  "VIGIL: a zero-knowledge dead man's switch on Midnight";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0c14",
          backgroundImage:
            "radial-gradient(circle at 50% 28%, rgba(240,161,74,0.22) 0%, rgba(240,161,74,0.06) 34%, rgba(10,12,20,0) 62%)",
          color: "#e9e2d2",
          fontFamily: "sans-serif",
        }}
      >
        {/* candle */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            marginBottom: 34,
          }}
        >
          <div
            style={{
              width: 34,
              height: 52,
              background: "#f0a14a",
              borderRadius: "50% 50% 42% 42%",
              boxShadow: "0 0 64px 26px rgba(240,161,74,0.35)",
            }}
          />
          <div
            style={{
              width: 5,
              height: 12,
              background: "#c8b69a",
              borderRadius: 3,
              marginTop: 4,
            }}
          />
          <div
            style={{
              width: 46,
              height: 74,
              background: "#e9e2d2",
              borderRadius: 9,
              marginTop: 4,
            }}
          />
        </div>

        <div
          style={{
            fontSize: 118,
            fontWeight: 700,
            letterSpacing: 26,
            marginLeft: 26, // optical centering against letter-spacing
            color: "#f2ecdd",
          }}
        >
          VIGIL
        </div>

        <div
          style={{
            fontSize: 34,
            marginTop: 22,
            color: "#b8b2a4",
            textAlign: "center",
          }}
        >
          A zero-knowledge dead man&apos;s switch on Midnight
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 44,
            fontSize: 24,
            color: "#5ad1a5",
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 12,
              background: "#5ad1a5",
            }}
          />
          <div>Live on Midnight Preprod, every action settles with a ZK proof</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
