import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * 页面级错误边界。
 *
 * 为什么要有它：React 组件在渲染时抛异常会把**整棵树**卸载，用户看到的就是一张
 * 白屏 —— 没有任何信息，根本没法排查（这次「五个页面打不开」就是这么表现出来的）。
 * 包一层之后，崩了会显示具体错误和堆栈首行，至少能定位是哪个页面、什么原因。
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 打到控制台方便复制给开发；不吞掉，界面上照样显示
    console.error('[PageErrorBoundary]', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div role="alert" style={{ padding: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 500, marginBottom: 8 }}>页面出错了</h2>
          <p style={{ marginBottom: 8 }}>
            这个页面渲染时抛了异常。下面是错误信息，截图发开发即可定位。
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              background: '#f6f6f6',
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            {error.message}
            {'\n\n'}
            {error.stack?.split('\n').slice(1, 6).join('\n')}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{ padding: '6px 16px', cursor: 'pointer' }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
