// Comprobación ejecutable del formato: node web/src/chat/format.check.ts
import assert from 'node:assert/strict';
import { renderBody } from './format.ts';

const ANA = '11111111-1111-1111-1111-111111111111';
const r = (s: string) => renderBody(s, (id) => (id === ANA ? 'Ana' : undefined), ANA);

assert.equal(r('**hola** _mundo_ ~no~'), '<strong>hola</strong> <em>mundo</em> <s>no</s>');
assert.equal(r('mira https://x.com/a_b_c ok'), 'mira <a href="https://x.com/a_b_c" target="_blank" rel="noopener noreferrer">https://x.com/a_b_c</a> ok');
assert.equal(r('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
assert.equal(r(`\`**no**\` <@${ANA}>`), '<code>**no**</code> <span class="mention me">@Ana</span>');
assert.equal(r('- uno\n- dos\nfin'), '<ul><li>uno</li><li>dos</li></ul>fin');
assert.equal(r('```\nconst a = 1;\n```'), '<pre><code>const a = 1;\n</code></pre>');
assert.equal(r('<a href="javascript:x">x</a>'), '&lt;a href=&quot;javascript:x&quot;&gt;x&lt;/a&gt;');
assert.equal(r('javascript:alert(1)'), 'javascript:alert(1)');
assert.equal(r('la «póliza» vence'), 'la <mark>póliza</mark> vence');
console.log('format OK');
