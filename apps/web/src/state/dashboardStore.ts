import { create } from "zustand";
import type { DashboardSpec } from "../types/spec";

type DashboardStore = {
  spec: DashboardSpec | null;
  history: DashboardSpec[];
  future: DashboardSpec[];
  setSpec: (spec: DashboardSpec) => void;
  replaceSpec: (spec: DashboardSpec) => void;
  pushSpec: (spec: DashboardSpec) => void;
  updateSpec: (updater: (spec: DashboardSpec) => DashboardSpec) => void;
  undo: () => void;
  redo: () => void;
};

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  spec: null,
  history: [],
  future: [],
  setSpec: (spec) => set({ spec, history: [], future: [] }),
  replaceSpec: (spec) => set({ spec }),
  pushSpec: (spec) =>
    set((state) => ({
      spec,
      history: state.spec ? [...state.history, state.spec] : state.history,
      future: [],
    })),
  updateSpec: (updater) => {
    const current = get().spec;
    if (!current) return;
    const next = updater(current);
    set((state) => ({
      spec: next,
      history: [...state.history, current],
      future: [],
    }));
  },
  undo: () =>
    set((state) => {
      if (state.history.length === 0 || !state.spec) return state;
      const prev = state.history[state.history.length - 1];
      return {
        spec: prev,
        history: state.history.slice(0, -1),
        future: [state.spec, ...state.future],
      };
    }),
  redo: () =>
    set((state) => {
      if (state.future.length === 0 || !state.spec) return state;
      const next = state.future[0];
      return {
        spec: next,
        history: [...state.history, state.spec],
        future: state.future.slice(1),
      };
    }),
}));
