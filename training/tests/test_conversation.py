"""Exercise the GGUF adapter contract without loading model weights."""
import importlib.util
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from origin_dataset import DatasetError

spec = importlib.util.spec_from_file_location("conversation_server", Path(__file__).resolve().parents[1] / "scripts/serve-conversation.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


@unittest.skipUnless(importlib.util.find_spec("llama_cpp"), "Install requirements-conversation.txt for GGUF tests")
class ConversationTests(unittest.TestCase):
    def setUp(self):
        self.runtime = server.Runtime.__new__(server.Runtime)
        self.runtime.lock = threading.Lock()
        self.runtime.timeout = 90
        self.runtime.model = Mock()
        self.runtime.model.create_completion.return_value = {
            "choices": [{"text": "こんにちは。", "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 4},
        }
        self.request = {"variant": "baseline", "max_new_tokens": 256, "messages": [
            {"role": "system", "content": "日本語で答えてください。"},
            {"role": "user", "content": "こんにちは"},
        ]}

    def test_chatml_completion_preserves_roles_and_stopping_criteria(self):
        from llama_cpp import Llama
        # autospec catches unsupported kwargs, such as stopping_criteria on chat completion.
        with patch.object(Llama, "create_completion", autospec=True) as completion:
            completion.return_value = self.runtime.model.create_completion.return_value
            self.runtime.model = Llama.__new__(Llama)
            result = self.runtime.complete(self.request)
        self.assertEqual(result["text"], "こんにちは。")
        self.assertEqual(result["finish_reason"], "eos")
        kwargs = completion.call_args.kwargs
        self.assertIn("<|im_start|>user\nこんにちは<|im_end|>", kwargs["prompt"])
        self.assertTrue(kwargs["prompt"].endswith("<|im_start|>assistant\n"))
        self.assertEqual(kwargs["stop"], "<|im_end|>")
        self.assertEqual(kwargs["max_tokens"], 256)
        self.assertTrue(kwargs["stopping_criteria"])

    def test_candidate_and_concurrent_generation_are_rejected(self):
        with self.assertRaises(DatasetError):
            self.runtime.complete({**self.request, "variant": "candidate"})
        self.runtime.lock.acquire()
        with self.assertRaises(DatasetError):
            self.runtime.complete(self.request)
        self.runtime.model.create_completion.assert_not_called()

    def test_generation_error_releases_lock(self):
        self.runtime.model.create_completion.side_effect = ValueError("context full")
        with self.assertRaises(ValueError):
            self.runtime.complete(self.request)
        self.assertFalse(self.runtime.lock.locked())

    def test_length_and_timeout_are_not_marked_complete(self):
        self.runtime.model.create_completion.return_value["choices"][0]["finish_reason"] = "length"
        self.assertEqual(self.runtime.complete(self.request)["finish_reason"], "length")
        with patch.object(server.time, "monotonic", side_effect=[0, 91]):
            self.assertEqual(self.runtime.complete(self.request)["finish_reason"], "timeout")
