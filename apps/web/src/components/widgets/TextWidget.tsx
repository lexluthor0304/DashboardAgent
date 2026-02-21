import type { TextWidget as TextWidgetType } from "../../types/spec";

export default function TextWidget(props: { widget: TextWidgetType }) {
  const { widget } = props;
  return (
    <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
      {widget.markdown.split("\n").map((line, idx) => (
        <div key={idx}>{line}</div>
      ))}
    </div>
  );
}

