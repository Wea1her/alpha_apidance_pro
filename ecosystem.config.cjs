module.exports = {
  apps: [
    {
      name: 'daxinjiankong',
      script: 'npm',
      args: 'start',
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '512M',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      time: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
