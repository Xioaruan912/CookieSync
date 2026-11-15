import path from 'node:path';

export function assertOutsideSource(source, target) {
  const relative = path.relative(path.resolve(source), path.resolve(target));
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('依赖、构建与输出目录必须位于源码项目之外');
  }
}

export function ownedPath(root, relative) {
  const target = path.resolve(root, relative);
  const value = path.relative(path.resolve(root), target);
  if (!value || value.startsWith('..' + path.sep) || value === '..' || path.isAbsolute(value))
    throw new Error('Invalid owned file path');
  return target;
}
