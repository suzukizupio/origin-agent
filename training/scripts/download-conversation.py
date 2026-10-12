"""Prepare the pinned Apache-2.0 Qwen3 conversation checkpoint in GGUF format."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request
from origin_dataset import canonical, require

repository = 'unsloth/Qwen3-4B-Instruct-2507-GGUF'
revision = 'a06e946bb6b655725eafa393f4a9745d460374c9'
filename = 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
output = Path('training/models/qwen3-conversation-4b-q4')
require(not (output / 'origin-chat.json').exists(), 'Conversation checkpoint is already prepared')
with urllib.request.urlopen(f'https://huggingface.co/api/models/{repository}/revision/{revision}', timeout=30) as response:
    info = json.load(response)
require(info['sha'] == revision and info.get('cardData', {}).get('license') == 'apache-2.0', 'Unexpected model revision or license')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
from huggingface_hub import hf_hub_download
path = Path(hf_hub_download(repository, filename, revision=revision, local_dir=str(output)))
with path.open('rb') as handle:
    sha = hashlib.file_digest(handle, 'sha256').hexdigest()
require(sha == '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597', 'Unexpected checkpoint checksum')
manifest = {'version':1, 'repository':repository, 'revision':revision, 'upstream_model':'Qwen/Qwen3-4B-Instruct-2507',
            'license':'apache-2.0', 'format':'gguf', 'quantization':'Q4_K_M', 'file':filename, 'sha256':sha}
(output / 'origin-chat.json').write_text(canonical(manifest) + '\n')
print(canonical({'prepared':True, **manifest}), flush=True)
