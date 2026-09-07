import { escapeHtml } from './html-escape';

describe('html-escape', () => {
  it('escapes reserved chars but keeps our tags usable', () => {
    expect(escapeHtml('<b>belajar</b> <script>alert(1)</script>')).toBe(
      '&lt;b&gt;belajar&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });
});