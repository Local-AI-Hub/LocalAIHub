const path = require('path');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const postcss = require('postcss');
const values = require('postcss-value-parser');
const sax = require('sax');

const resourceKeys = new Set(['src', 'href', 'xlink:href', 'poster', 'uri', 'url', 'data-composition-src']);
const assetAttributes = new Set([...resourceKeys, 'srcset', 'imagesrcset', 'action', 'formaction']);

function staticText(expression, seen = new Set()) {
  const n = expression?.node;
  if (!n || seen.has(n) || seen.size > 32) return '';
  const next = new Set(seen).add(n);
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis[0].value.cooked || '';
  if (n.type === 'BinaryExpression' && n.operator === '+') return staticText(expression.get('left'), next) + staticText(expression.get('right'), next);
  if (n.type === 'Identifier') {
    const binding = expression.scope.getBinding(n.name);
    if (binding?.constant && binding.path.isVariableDeclarator()) return staticText(binding.path.get('init'), next);
  }
  if (n.type === 'MemberExpression' && n.property.name === 'href') return staticText(expression.get('object'), next);
  if (n.type === 'NewExpression' && n.callee.name === 'URL') return staticText(expression.get('arguments.0'), next);
  return '';
}

function findReferences(source, filename) {
  const findings = [];
  function check(value, line, kind) {
    const text = String(value || '').trim();
    if (!/^(?:https?:\/\/|\/\/[^/]|data:)/i.test(text)) return;
    let reference = 'data URL';
    if (!/^data:/i.test(text)) {
      try { reference = new URL(text, 'https://localhost').hostname; } catch { reference = 'remote URL'; }
    }
    findings.push({ file: filename, line, kind, reference, category: reference === 'data URL' ? 'data-url-reference' : 'remote-http-reference' });
  }
  function js(code, base) {
    let ast;
    try { ast = parse(code, { sourceType: 'unambiguous', allowReturnOutsideFunction: true }); }
    catch (error) { throw new Error('Could not inspect JavaScript in ' + filename + ' at line ' + (base + (error.loc?.line || 1) - 1) + '. ' + error.reasonCode); }
    function inspect(p, expression, kind) { check(staticText(expression), base + p.node.loc.start.line - 1, kind); }
    traverse(ast, {
      'ImportDeclaration|ExportAllDeclaration|ExportNamedDeclaration'(p) { if (p.node.source) inspect(p, p.get('source'), 'module source'); },
      'CallExpression|NewExpression|OptionalCallExpression'(p) {
        const callee = p.node.callee;
        const name = callee.type === 'Import' ? 'import' : callee.name || callee.property?.name;
        const args = p.get('arguments');
        if (['fetch','import','Worker','SharedWorker','Request','EventSource','WebSocket','sendBeacon','loadAsync'].includes(name)) inspect(p, args[0], name);
        if (name === 'importScripts') for (const a of args) inspect(p,a,name);
        if (name === 'open' && args.length >= 2 && /^(GET|POST|HEAD|PUT|PATCH|DELETE|OPTIONS)$/i.test(staticText(args[0]))) inspect(p,args[1],'XHR open');
        if (name === 'setAttribute' && assetAttributes.has(staticText(args[0]).toLowerCase())) inspect(p,args[1],'resource attribute');
      },
      AssignmentExpression(p) {
        const left = p.node.left;
        if (left.type === 'MemberExpression' && assetAttributes.has(left.property.name || left.property.value)) inspect(p,p.get('right'),'resource property');
      },
    });
  }
  function css(code, base) {
    let sheet;
    try { sheet = postcss.parse(code, { from: undefined }); }
    catch (error) { throw new Error('Could not inspect CSS in ' + filename + ' at line ' + (base + (error.line || 1) - 1) + '.'); }
    sheet.walk(node => {
      const isImport = node.type === 'atrule' && node.name.toLowerCase() === 'import';
      if (!isImport && node.type !== 'decl') return;
      const value = values(isImport ? node.params : node.value);
      const line = base + node.source.start.line - 1;
      if (isImport && value.nodes[0]?.type === 'string') check(value.nodes[0].value,line,'CSS @import');
      value.walk(token => {
        if (token.type === 'function' && token.value.toLowerCase() === 'url') check(token.nodes?.[0]?.value,line,isImport ? 'CSS @import' : 'CSS url');
      });
    });
  }
  function json(code, base, importMap) {
    let expr;
    try { JSON.parse(code); expr = require('@babel/parser').parseExpression(code.trimStart(), { startLine: base + code.slice(0,code.length-code.trimStart().length).split('\n').length - 1 }); }
    catch { throw new Error('Could not inspect JSON in ' + filename + ' starting at line ' + base + '.'); }
    function visit(node, key, targets) {
      if (node.type === 'ObjectExpression') {
        for (const property of node.properties) {
          const name = String(property.key.value);
          visit(property.value,name,targets || (importMap && ['imports','scopes'].includes(name)));
        }
      } else if (node.type === 'ArrayExpression') {
        for (const item of node.elements) visit(item,key,targets);
      } else if (node.type === 'StringLiteral' && (targets || resourceKeys.has(key.toLowerCase()) || ['urls','uris','sources'].includes(key.toLowerCase()))) {
        check(node.value,node.loc.start.line,targets ? 'import map target' : 'JSON ' + key);
      }
    }
    importMap ||= expr.type === 'ObjectExpression' && expr.properties.some(p => p.key?.value === 'imports' && p.value?.type === 'ObjectExpression');
    visit(expr,'',false);
  }
  const ext = path.extname(filename).toLowerCase();
  if (!/(?:https?:|\/\/|data:|\\u00)/i.test(source)) return findings;
  if (['.js','.mjs','.cjs'].includes(ext)) js(source,1);
  else if (ext === '.css') css(source,1);
  else if (['.json','.gltf','.webmanifest'].includes(ext)) json(source,1,/import.?map/i.test(path.basename(filename)));
  else if (['.html','.htm','.svg'].includes(ext)) {
    const prefix = '<hub-fragment>';
    const parser = sax.parser(false,{lowercase:true});
    let inline;
    const lineAt = index => source.slice(0,Math.max(0,index)).split('\n').length;
    parser.onopentag = tag => {
      const base = lineAt(parser.startTagPosition - prefix.length - 1);
      for (const [key,value] of Object.entries(tag.attributes)) {
        if (key === 'srcset' || key === 'imagesrcset') {
          for (const candidate of value.split(/,\s*(?!base64)/)) check(candidate.trim().split(/\s/)[0],base,key);
        } else if (assetAttributes.has(key) || (tag.name === 'object' && key === 'data')) check(value,base,'attribute ' + key);
        else if (key === 'style') css(value,base);
        else if (ext === '.svg' && /url\s*\(/i.test(value)) css('x:'+value,base);
      }
      if (tag.name === 'script' || tag.name === 'style') inline = { name:tag.name, type:tag.attributes.type || '', start:parser.position - prefix.length, base:parser.line + 1 };
    };
    parser.onclosetag = name => {
      if (inline?.name !== name) return;
      const end = source.lastIndexOf('</',parser.position - prefix.length - 1);
      const code = source.slice(inline.start,end);
      if (name === 'style') css(code,inline.base);
      else if (/importmap|application\/(?:ld\+)?json/i.test(inline.type)) json(code,inline.base,/importmap/i.test(inline.type));
      else if (!inline.type || /module|javascript|ecmascript/i.test(inline.type)) js(code,inline.base);
      inline = null;
    };
    parser.write(prefix + source + '</hub-fragment>').close();
  }
  return findings;
}

module.exports = { findReferences, findReference: (source, file) => findReferences(source,file)[0] };
