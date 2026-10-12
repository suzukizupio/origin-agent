"""Loopback-only Qwen3 GGUF inference with the existing Origin HTTP contract."""
import argparse
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
from origin_dataset import canonical, digest, require
from origin_model_server import handler_for

class Runtime:
    def __init__(self, args):
        manifest = json.loads((args.model / 'origin-chat.json').read_text())
        require(manifest['format'] == 'gguf' and manifest['license'] == 'apache-2.0', 'Invalid conversation checkpoint')
        require(Path(manifest['file']).name == manifest['file'], 'Invalid model filename')
        weights = args.model / manifest['file']
        with weights.open('rb') as handle:
            require(hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['sha256'], 'Model weights changed after download')
        from llama_cpp import Llama
        self.model = Llama(model_path=str(weights), n_ctx=4096, n_threads=args.threads, n_threads_batch=args.threads,
                           n_batch=256, seed=42, chat_format='chatml', verbose=False)
        self.lock = threading.Lock()
        self.max_output = 256
        self.timeout = args.generation_timeout
        self.identity = {'ready':True, 'base_repository':manifest['repository'], 'base_revision':manifest['revision'],
                         'base_sha256':digest(manifest), 'adapter_sha256':None, 'variants':['baseline'],
                         'quantization':manifest['quantization'], 'weight_sha256':manifest['sha256'],
                         'threads':args.threads, 'max_input_tokens':4096, 'max_output_tokens':self.max_output,
                         'generation':{'temperature':0, 'repeat_penalty':1.0, 'seed':42, 'chat_format':'chatml'}}

    def complete(self, request):
        require(request['variant'] == 'baseline', 'This conversation model has no project-trained adapter')
        require(self.lock.acquire(blocking=False), 'Conversation model is busy')
        try:
            from llama_cpp import StoppingCriteriaList
            from llama_cpp.llama_chat_format import format_chatml
            started = time.monotonic()
            formatted = format_chatml(request['messages'])
            output = self.model.create_completion(prompt=formatted.prompt, stop=formatted.stop, temperature=0,
                repeat_penalty=1.0, max_tokens=request['max_new_tokens'],
                stopping_criteria=StoppingCriteriaList([lambda _ids, _logits: time.monotonic() - started >= self.timeout]))
            elapsed = time.monotonic() - started
            choice = output['choices'][0]
            reason = 'timeout' if elapsed >= self.timeout else 'eos' if choice['finish_reason'] == 'stop' else 'length'
            return {'variant':'baseline', 'text':choice['text'] or '', 'finish_reason':reason,
                    'elapsed_ms':round(elapsed * 1000), 'prompt_tokens':output['usage']['prompt_tokens'],
                    'output_tokens':output['usage']['completion_tokens']}
        except Exception as error:
            print('Generation failed: ' + type(error).__name__, flush=True)
            raise
        finally:
            self.lock.release()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=Path('training/models/qwen3-conversation-4b-q4'))
    parser.add_argument('--port', type=int, default=18083)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--generation-timeout', type=float, default=90)
    args = parser.parse_args()
    require(1 <= args.port <= 65535 and 1 <= args.threads <= 32 and args.generation_timeout > 0, 'Invalid runtime limits')
    runtime = Runtime(args)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler_for(runtime))
    print(canonical({'listening':f'http://127.0.0.1:{args.port}', **runtime.identity}), flush=True)
    try: server.serve_forever()
    finally: server.server_close()

if __name__ == '__main__':
    main()
