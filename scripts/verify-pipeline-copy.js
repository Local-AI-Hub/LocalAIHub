const assert = require('assert');

const {
  createEdge,
  createEmptyPipeline,
  createNode,
  createPipelineDefinitionCopy,
  getPipelineCopyName,
} = require('../electron/shared/pipelineSchema.cjs');

function main() {
  assert.strictEqual(getPipelineCopyName('Original name', []), 'Original name (copy)');
  assert.strictEqual(
    getPipelineCopyName('Original name', [{ name: 'Original name (copy)' }]),
    'Original name (copy 2)',
    'Expected copy names to use a safe numbered suffix.',
  );

  const firstNode = createNode('textInput', {
    id: 'source-text',
    config: { text: 'hello' },
    position: { x: 44, y: 55 },
  });
  const secondNode = createNode('textOutput', {
    id: 'final-text',
    config: { title: 'Final' },
    position: { x: 400, y: 65 },
  });
  const edge = createEdge(firstNode.id, 'text', secondNode.id, 'text', { id: 'edge-text-final' });
  const source = {
    ...createEmptyPipeline({
      id: 'original-pipeline',
      name: 'Original name',
      description: 'Keep this description.',
      runSettings: { enableHeavyStepCooldown: true, heavyStepCooldownSeconds: 12 },
      nodes: [firstNode, secondNode],
      edges: [edge],
    }),
    generatedArtifacts: [{ filePath: 'should-not-copy.png' }],
    runHistory: [{ runId: 'run-1' }],
    savedOutputs: [{ filePath: 'output.mp4' }],
  };

  const copy = createPipelineDefinitionCopy(source, [
    { name: 'Original name' },
    { name: 'Original name (copy)' },
  ]);

  assert.notStrictEqual(copy.id, source.id, 'Expected copy to receive a fresh pipeline id.');
  assert.strictEqual(copy.name, 'Original name (copy 2)', 'Expected copy to receive a unique copy name.');
  assert.strictEqual(copy.description, source.description, 'Expected copy to preserve pipeline setup description.');
  assert.deepStrictEqual(copy.runSettings, source.runSettings, 'Expected copy to preserve run settings.');
  assert.deepStrictEqual(copy.nodes, source.nodes, 'Expected copy to preserve nodes, config, and canvas positions.');
  assert.deepStrictEqual(copy.edges, source.edges, 'Expected copy to preserve edges.');
  assert.notStrictEqual(copy.nodes, source.nodes, 'Expected node array to be deep-copied.');
  assert.notStrictEqual(copy.nodes[0], source.nodes[0], 'Expected node objects to be deep-copied.');
  assert.strictEqual(copy.runHistory, undefined, 'Expected copy to omit run history.');
  assert.strictEqual(copy.generatedArtifacts, undefined, 'Expected copy to omit generated artifacts.');
  assert.strictEqual(copy.savedOutputs, undefined, 'Expected copy to omit saved outputs.');

  copy.nodes[0].config.text = 'changed copy only';
  assert.strictEqual(source.nodes[0].config.text, 'hello', 'Expected copy edits not to mutate the original pipeline.');

  console.log('Pipeline copy verification passed.');
}

main();