import type { PluginsState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Installed plugins in the office. */
    plugins: PluginsState;
  }
  interface Topics {
    plugins: true;
  }
}

export const plugins: Slice = {
  init(s) {
    s.plugins = { plugins: [] };
  },
  on: {
    welcome(s, m) {
      if (m.plugins) s.plugins = m.plugins;
      return ['plugins'];
    },
    plugins(s, m) {
      s.plugins = m.state;
      return ['plugins'];
    },
  },
};
