import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
async function copy(source,target){await mkdir(resolve(root,target,'..'),{recursive:true});await copyFile(resolve(root,source),resolve(root,target));}
await copy('node_modules/tesseract.js/dist/worker.min.js','public/ocr/worker.min.js');
// .wasm.js builds embed their WASM bytes. Both modern and legacy variants remain local.
for(const file of await readdir(resolve(root,'node_modules/tesseract.js-core'))){if(file.endsWith('.wasm.js'))await copy(`node_modules/tesseract.js-core/${file}`,`public/ocr/core/${file}`);}
await copy('node_modules/tesseract.js-core/LICENSE','public/ocr/core/LICENSE');
await copy('node_modules/@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz','public/ocr/lang/por.traineddata.gz');
for(const file of await readdir(resolve(root,'node_modules/pdfjs-dist/standard_fonts')))await copy(`node_modules/pdfjs-dist/standard_fonts/${file}`,`public/pdf-fonts/${file}`);
for(const file of await readdir(resolve(root,'node_modules/pdfjs-dist/cmaps')))await copy(`node_modules/pdfjs-dist/cmaps/${file}`,`public/pdf-cmaps/${file}`);
