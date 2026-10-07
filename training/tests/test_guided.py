import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from origin_guided import GuidedTools, tool_parser


@unittest.skipUnless(importlib.util.find_spec("lmformatenforcer"), "Optional pinned inference dependency is not installed")
class GuidedTests(unittest.TestCase):
    def accepts(self, text):
        parser = tool_parser(''.join(chr(i) for i in range(32, 127)) + '\n\r\tテスト完了。')
        for character in text:
            if character not in parser.get_allowed_characters(): return False
            parser = parser.add_character(character)
        return parser.can_end()

    def test_tools_require_complete_json_one_call_and_a_return_statement(self):
        patch = {"path": "src/example.js", "old_string": "return value;", "new_string": "return Math.max(-6, Math.min(10, value));"}
        call = '<tool name="edit_file">\n' + json.dumps(patch) + '\n</tool>'
        self.assertTrue(self.accepts(call))
        self.assertFalse(self.accepts(call + call))
        for change in ({"new_string": "return value}"}, {"new_string": "return value"}, {"old_string": "return value"}):
            self.assertFalse(self.accepts('<tool name="edit_file">\n' + json.dumps({**patch, **change}) + '\n</tool>'))
        self.assertFalse(self.accepts(call.replace('"path":', '"wrong":')))
        self.assertTrue(self.accepts('テスト完了。'))

    def test_grammar_does_not_select_the_correct_expression(self):
        for expression in ("return value + 99;", "return value && value >= 9 ? true : false;", "return value * 2 + (-1);"):
            patch = {"path": "src/other.js", "old_string": "return value;", "new_string": expression}
            self.assertTrue(self.accepts('<tool name="edit_file">\n' + json.dumps(patch) + '\n</tool>'))

    @unittest.skipUnless(importlib.util.find_spec("transformers"), "Inference integration is not installed")
    def test_token_filter_keeps_branches_separate_and_stops_after_one_tool(self):
        from lmformatenforcer import TokenEnforcerTokenizerData
        tokens = [(i, chr(i), False) for i in range(128)]
        data = TokenEnforcerTokenizerData(tokens, lambda ids: ''.join(chr(i) for i in ids), 128, False, 129)
        guided = GuidedTools.__new__(GuidedTools)
        guided.data = data
        guided.text_tokens = [i for i in range(128) if chr(i) != '<']
        guided.end_tokens = [128]
        class Sent(list):
            def tolist(self): return list(self)
        for text in ('<tool name="read_file">\n{"path":"src/example.js"}\n</tool>', 'Tests passed.'):
            prefix = guided.prefix(); sent = Sent([1])
            for character in text:
                self.assertIn(ord(character), prefix(0, sent))
                sent.append(ord(character))
            allowed = prefix(0, sent)
            self.assertIn(128, allowed)
            self.assertNotIn(ord('<'), allowed)


if __name__ == "__main__": unittest.main()
