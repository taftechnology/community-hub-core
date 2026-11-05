/**
 * Synthetic fixture corpus for Mass Times rich text sanitiser.
 * Covers allowed tags, transforms, container tags, edge-case HTML constructs,
 * and hostile input vectors.
 */

export const ALLOWED_TAGS_FIXTURES: readonly {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}[] = [
  {
    name: "paragraph",
    input: "<p>Sunday Mass at 10:00 AM</p>",
    expected: "<p>Sunday Mass at 10:00 AM</p>",
  },
  {
    name: "headings h1 to h4",
    input: "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3><h4>Subsection</h4>",
    expected: "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3><h4>Subsection</h4>",
  },
  {
    name: "strong and em",
    input: "<p><strong>Solemnity</strong> and <em>Vigil</em></p>",
    expected: "<p><strong>Solemnity</strong> and <em>Vigil</em></p>",
  },
  {
    name: "transform b to strong and i to em",
    input: "<p><b>Bold Mass</b> and <i>Italic Mass</i></p>",
    expected: "<p><strong>Bold Mass</strong> and <em>Italic Mass</em></p>",
  },
  {
    name: "line break br",
    input: "<p>Morning Mass: 9:00 AM<br>Evening Mass: 6:00 PM</p>",
    expected: "<p>Morning Mass: 9:00 AM<br />Evening Mass: 6:00 PM</p>",
  },
  {
    name: "unordered list",
    input: "<ul><li>Sunday 9am</li><li>Sunday 11am</li></ul>",
    expected: "<ul><li>Sunday 9am</li><li>Sunday 11am</li></ul>",
  },
  {
    name: "ordered list",
    input: "<ol><li>First Reading</li><li>Responsorial Psalm</li></ol>",
    expected: "<ol><li>First Reading</li><li>Responsorial Psalm</li></ol>",
  },
];

export const UNWRAPPED_TAGS_FIXTURES: readonly {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}[] = [
  {
    name: "div is unwrapped, allowed child kept",
    input: "<div><p>Mass Times</p></div>",
    expected: "<p>Mass Times</p>",
  },
  {
    name: "span keeps text only",
    input: "<p><span>Parish Service</span></p>",
    expected: "<p>Parish Service</p>",
  },
  {
    name: "u keeps text only",
    input: "<p><u>Underlined schedule</u></p>",
    expected: "<p>Underlined schedule</p>",
  },
  {
    name: "anchor link keeps text only",
    input: '<p><a href="https://parish.example.com">Visit bulletin</a></p>',
    expected: "<p>Visit bulletin</p>",
  },
  {
    name: "blockquote unwrapped",
    input: "<blockquote><p>Rejoice always</p></blockquote>",
    expected: "<p>Rejoice always</p>",
  },
  {
    name: "table unwrapped to text",
    input: "<table><tr><td>Saturday 5pm</td><td>Sunday 10am</td></tr></table>",
    expected: "Saturday 5pmSunday 10am",
  },
];

export const DROPPED_CONTAINER_FIXTURES: readonly {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}[] = [
  {
    name: "script dropped with content",
    input: "<script>alert('pwned')</script>",
    expected: "",
  },
  {
    name: "style dropped with content",
    input: "<style>body { display: none; }</style>",
    expected: "",
  },
  {
    name: "iframe dropped with content",
    input: '<iframe src="https://example.com"><p>fallback</p></iframe>',
    expected: "",
  },
  {
    name: "object dropped with content",
    input: '<object data="test.swf"><p>fallback</p></object>',
    expected: "",
  },
  {
    name: "embed dropped with content",
    input: '<embed src="malicious.swf">',
    expected: "",
  },
  {
    name: "svg with circle dropped",
    input: "<svg><circle cx='50' cy='50' r='40'></circle></svg>",
    expected: "",
  },
  {
    name: "svg with nested allowed p tag dropped completely",
    input: "<svg><p>x</p></svg>",
    expected: "",
  },
  {
    name: "svg with nested p dropped while sibling allowed tag is kept",
    input: "<p>keep</p><svg><p>x</p></svg>",
    expected: "<p>keep</p>",
  },
  {
    name: "math with nested allowed tag dropped",
    input: "<math><p>formula text</p></math>",
    expected: "",
  },
  {
    name: "template with nested allowed tag dropped",
    input: "<template><p>template text</p></template>",
    expected: "",
  },
  {
    name: "noscript with nested allowed tag dropped",
    input: "<noscript><p>noscript text</p></noscript>",
    expected: "",
  },
  {
    name: "textarea with nested allowed tag dropped",
    input: "<textarea><p>textarea text</p></textarea>",
    expected: "",
  },
  {
    name: "option with nested allowed tag dropped",
    input: "<option><p>option text</p></option>",
    expected: "",
  },
];

export const EDGE_CASE_FIXTURES: readonly {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}[] = [
  {
    name: "</br> closing break",
    input: "<p>Morning</br>Evening</p>",
    expected: "<p>Morning<br />Evening</p>",
  },
  {
    name: "<br/> self-closing break",
    input: "<p>Morning<br/>Evening</p>",
    expected: "<p>Morning<br />Evening</p>",
  },
  {
    name: "<BR> uppercase break",
    input: "<p>Morning<BR>Evening</p>",
    expected: "<p>Morning<br />Evening</p>",
  },
  {
    name: "p inside li",
    input: "<ul><li><p>Sunday Mass</p></li></ul>",
    expected: "<ul><li><p>Sunday Mass</p></li></ul>",
  },
  {
    name: "ul > li > ol nested lists",
    input: "<ul><li>Weekend<ol><li>Saturday 5pm</li><li>Sunday 10am</li></ol></li></ul>",
    expected: "<ul><li>Weekend<ol><li>Saturday 5pm</li><li>Sunday 10am</li></ol></li></ul>",
  },
  {
    name: "&nbsp; kept as U+00A0 non-breaking space",
    input: "<p>10:00&nbsp;AM</p>",
    expected: "<p>10:00\u00A0AM</p>",
  },
  {
    name: "&lt;script&gt; stays escaped text",
    input: "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    expected: "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  },
  {
    name: "stray closing </p> tag alone does not survive",
    input: "</p>",
    expected: "",
  },
  {
    name: "unclosed paragraph",
    input: "<p>Unclosed paragraph",
    expected: "<p>Unclosed paragraph</p>",
  },
  {
    name: "HTML comment is removed",
    input: "<p>Mass<!-- comment --> Times</p>",
    expected: "<p>Mass Times</p>",
  },
  {
    name: "CDATA is removed",
    input: "<p>Mass<![CDATA[cdata content]]> Times</p>",
    expected: "<p>Mass Times</p>",
  },
  {
    name: "XML processing instruction is removed",
    input: '<?xml version="1.0" encoding="utf-8"?><p>Mass Times</p>',
    expected: "<p>Mass Times</p>",
  },
];

export const EMPTY_NORMALISATION_FIXTURES: readonly {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}[] = [
  {
    name: "empty paragraph <p></p>",
    input: "<p></p>",
    expected: "",
  },
  {
    name: "paragraph with break <p><br></p>",
    input: "<p><br></p>",
    expected: "",
  },
  {
    name: "heading with whitespace <h1> </h1>",
    input: "<h1> </h1>",
    expected: "",
  },
  {
    name: "nested empty list <ul><li><p></p></li></ul>",
    input: "<ul><li><p></p></li></ul>",
    expected: "",
  },
  {
    name: "empty string",
    input: "",
    expected: "",
  },
  {
    name: "whitespace only",
    input: "   \n\t  ",
    expected: "",
  },
  {
    name: "real text with empty paragraph is NOT normalised to empty",
    input: "<p>Real text</p><p></p>",
    expected: "<p>Real text</p><p></p>",
  },
];

export const HOSTILE_INPUT_SUITE: readonly string[] = [
  "<script>alert(1)</script>",
  '<SCRIPT SRC="https://evil.example.com/xss.js"></SCRIPT>',
  '<script type="text/javascript">alert(1);</script>',
  "<script src=data:text/javascript,alert(1)>",
  "<p onclick=\"alert('xss')\">Click</p>",
  "<p onmouseover=\"alert('xss')\">Hover</p>",
  '<img src="x" onerror="alert(1)">',
  "<img src=\"javascript:alert('XSS')\">",
  "<a href=\"javascript:alert('XSS')\">link</a>",
  "<a href=\"jav&#x09;ascript:alert('XSS');\">link</a>",
  "<a href=\"jav&#x0A;ascript:alert('XSS');\">link</a>",
  "<a href=\"jav&#x0D;ascript:alert('XSS');\">link</a>",
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">link</a>',
  "<iframe src=\"javascript:alert('XSS')\"></iframe>",
  '<iframe src="https://evil.example.com"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  "<svg onload=\"alert('XSS')\"><p>xss</p></svg>",
  "<svg><script>alert(1)</script></svg>",
  "<svg><circle></circle></svg>",
  "<svg/onload=alert(1)>",
  '<math href="javascript:alert(1)"><mi>test</mi></math>',
  "<template><script>alert(1)</script></template>",
  "<noscript><p>noscript</p></noscript>",
  "<textarea><script>alert(1)</script></textarea>",
  "<style>@import 'javascript:alert(1)';</style>",
  "<style>body { background: url('javascript:alert(1)'); }</style>",
  "<!-- <script>alert(1)</script> -->",
  "<![CDATA[<script>alert(1)</script>]]>",
  '<?xml version="1.0" encoding="ISO-8859-1"?><foo>bar</foo>',
  '<div style="background-image: url(javascript:alert(1))">test</div>',
  '<form action="javascript:alert(1)"><button>submit</button></form>',
  '<input type="text" value="val" onfocus="alert(1)">',
  '<b oncut="alert(1)">bold</b>',
  '<i oncopy="alert(1)">italic</i>',
  '<p id="test" class="foo" style="color:red" data-secret="123" start="5">text</p>',
  '<ol start="5"><li>first</li></ol>',
  '<body onload="alert(1)">hello</body>',
  '<link rel="stylesheet" href="javascript:alert(1)">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
];

/**
 * Combined corpus for idempotence and general corpus testing.
 */
export const FIXTURE_CORPUS: readonly string[] = [
  ...ALLOWED_TAGS_FIXTURES.map((f) => f.input),
  ...UNWRAPPED_TAGS_FIXTURES.map((f) => f.input),
  ...DROPPED_CONTAINER_FIXTURES.map((f) => f.input),
  ...EDGE_CASE_FIXTURES.map((f) => f.input),
  ...EMPTY_NORMALISATION_FIXTURES.map((f) => f.input),
  ...HOSTILE_INPUT_SUITE,
  "&nbsp;",
  "&lt;script&gt;",
  "</br>",
  "<br/>",
  "<BR>",
  "</p>",
];
