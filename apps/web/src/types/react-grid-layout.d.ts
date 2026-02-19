declare module "react-grid-layout" {
  import * as React from "react";

  export type Layout = {
    i: string;
    x: number;
    y: number;
    w: number;
    h: number;
    minW?: number;
    maxW?: number;
    minH?: number;
    maxH?: number;
    static?: boolean;
    isDraggable?: boolean;
    isResizable?: boolean;
  };

  export type ReactGridLayoutProps = {
    className?: string;
    layout?: Layout[];
    cols?: number;
    rowHeight?: number;
    margin?: [number, number];
    containerPadding?: [number, number];
    isDraggable?: boolean;
    isResizable?: boolean;
    onLayoutChange?: (layout: Layout[]) => void;
    children?: React.ReactNode;
  };

  const GridLayout: React.ComponentType<ReactGridLayoutProps>;
  export default GridLayout;

  export function WidthProvider<TProps>(
    component: React.ComponentType<TProps>,
  ): React.ComponentType<TProps & { width?: number }>;
}

