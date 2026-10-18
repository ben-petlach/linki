# LinkedIn messaging reference

`lib/linkedin/inbox.ts` adapts the Voyager messaging query shape, query IDs,
cursor handling, and Rest.li variable encoding documented in
[OpenRecruiterTools/linkedin-toolkit](https://github.com/OpenRecruiterTools/linkedin-toolkit/tree/7937c834dd068b35ace372f4f39da85ad82f7ac7),
particularly `extension/src/background/voyager.js`,
`extension/src/background/voyager-core.js`, and
`extension/tests/fixtures/voyager/`. That project's captures are dated
September 8, 2026. LinkedIn can change this private interface; this fork has
only exercised sanitized local fixtures.

MIT License

Copyright (c) 2026 Dominic Gonsalves

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
