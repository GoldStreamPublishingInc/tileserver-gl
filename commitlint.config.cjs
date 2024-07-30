module.exports = {
  extends: ['@commitlint/config-conventional'],
  ignores: [(msg) => msg.includes('AA:')]
};
