import { ImageResponse } from "next/og";

// Home-screen icon (Prompt 82): the brand mark from icon.svg, drawn at build time as a 180 px
// PNG (iOS doesn't use SVG icons and rounds the corners itself).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#050806",
      }}
    >
      <div
        style={{
          width: 84,
          height: 84,
          borderRadius: 25,
          transform: "rotate(45deg)",
          backgroundImage:
            "linear-gradient(135deg, #e9f2ec, #a8c5b3 50%, #16a34a)",
        }}
      />
    </div>,
    size
  );
}
