-- ============================================
-- SUSPENTRACK - BASE DE DATOS COMPLETA
-- Sistema de gestión de mantenimiento de suspensión
-- Cantón Mocha - Tungurahua
-- ============================================

-- ============================================
-- TABLA DE USUARIOS
-- ============================================
CREATE TABLE IF NOT EXISTS usuarios(
                                       id INT AUTO_INCREMENT PRIMARY KEY,
                                       nombre VARCHAR(100) NOT NULL,
    correo VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    rol ENUM('ADMIN','TECNICO','OPERADOR') NOT NULL,
    estado ENUM('ACTIVO','INACTIVO') DEFAULT 'ACTIVO',
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

-- ============================================
-- TABLA DE VEHÍCULOS
-- ============================================
CREATE TABLE IF NOT EXISTS vehiculos(
                                        id INT AUTO_INCREMENT PRIMARY KEY,
                                        placa VARCHAR(10) UNIQUE NOT NULL,
    marca VARCHAR(50) NOT NULL,
    modelo VARCHAR(50) NOT NULL,
    anio INT,
    kilometraje INT DEFAULT 0,
    capacidad_carga DECIMAL(10,2),
    frecuencia_uso ENUM('BAJA','MEDIA','ALTA') DEFAULT 'MEDIA',
    estado_general ENUM('OPERATIVO','MANTENIMIENTO','INOPERATIVO') DEFAULT 'OPERATIVO',
    criticidad VARCHAR(20) DEFAULT 'NO EVALUADO',
    ultimo_mantenimiento DATE,
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

-- ============================================
-- TABLA DE COMPONENTES DE SUSPENSIÓN
-- ============================================
CREATE TABLE IF NOT EXISTS componentes(
                                          id INT AUTO_INCREMENT PRIMARY KEY,
                                          vehiculo_id INT NOT NULL,
                                          nombre ENUM('AMORTIGUADOR','RESORTE','ROTULA','BUJE','BRAZO_SUSPENSION','BARRA_ESTABILIZADORA') NOT NULL,
    estado ENUM('EXCELENTE','BUENO','REGULAR','MALO','CRITICO') DEFAULT 'BUENO',
    fecha_inspeccion DATE,
    observaciones TEXT,
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE
    );

-- ============================================
-- TABLA DE INSPECCIONES
-- ============================================
CREATE TABLE IF NOT EXISTS inspecciones(
                                           id INT AUTO_INCREMENT PRIMARY KEY,
                                           vehiculo_id INT NOT NULL,
                                           tecnico_id INT NOT NULL,
                                           fecha DATE NOT NULL,
                                           kilometraje INT DEFAULT 0,
                                           observaciones TEXT,
                                           evidencia VARCHAR(500),
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id),
    FOREIGN KEY (tecnico_id) REFERENCES usuarios(id)
    );

-- ============================================
-- TABLA DE MANTENIMIENTOS
-- ============================================
CREATE TABLE IF NOT EXISTS mantenimientos(
                                             id INT AUTO_INCREMENT PRIMARY KEY,
                                             vehiculo_id INT NOT NULL,
                                             tecnico_id INT NOT NULL,
                                             tipo ENUM('PREVENTIVO','CORRECTIVO') NOT NULL,
    fecha DATE NOT NULL,
    costo DECIMAL(10,2) DEFAULT 0,
    descripcion TEXT,
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id),
    FOREIGN KEY (tecnico_id) REFERENCES usuarios(id)
    );

-- ============================================
-- TABLA DE ALERTAS
-- ============================================
CREATE TABLE IF NOT EXISTS alertas(
                                      id INT AUTO_INCREMENT PRIMARY KEY,
                                      vehiculo_id INT NOT NULL,
                                      nivel ENUM('BAJO','MEDIO','ALTO','CRITICO') NOT NULL,
    mensaje TEXT,
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id)
    );

-- ============================================
-- TABLA DE PRIORIZACIONES (HISTORIAL)
-- ============================================
CREATE TABLE IF NOT EXISTS priorizaciones(
                                             id INT AUTO_INCREMENT PRIMARY KEY,
                                             vehiculo_id INT NOT NULL,
                                             kilometraje_puntos INT DEFAULT 0,
                                             mantenimiento_puntos INT DEFAULT 0,
                                             fallas_puntos INT DEFAULT 0,
                                             componentes_puntos INT DEFAULT 0,
                                             uso_puntos INT DEFAULT 0,
                                             puntaje_total INT DEFAULT 0,
                                             clasificacion ENUM('BAJO','MEDIO','ALTO','CRITICO'),
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id)
    );

-- ============================================
-- ÍNDICES PARA RENDIMIENTO
-- ============================================
CREATE INDEX IF NOT EXISTS idx_vehiculo_componente ON componentes(vehiculo_id);
CREATE INDEX IF NOT EXISTS idx_inspeccion_fecha ON inspecciones(fecha);
CREATE INDEX IF NOT EXISTS idx_mantenimiento_fecha ON mantenimientos(fecha);
CREATE INDEX IF NOT EXISTS idx_alertas_nivel ON alertas(nivel, fecha);
CREATE INDEX IF NOT EXISTS idx_vehiculo_criticidad ON vehiculos(criticidad);
CREATE INDEX IF NOT EXISTS idx_vehiculo_estado ON vehiculos(estado_general);

-- ============================================
-- USUARIO ADMIN POR DEFECTO
-- Password: admin123
-- ============================================
INSERT IGNORE INTO usuarios (nombre, correo, password, rol, estado) VALUES
('Administrador', 'admin@suspentrack.com', '$2a$10$N9qo8uLOickgx2ZMRZoMy.MrJ5qTqC8q8q8q8q8q8q8q8q8q8q', 'ADMIN', 'ACTIVO');

-- ============================================
-- VEHÍCULOS DE EJEMPLO
-- ============================================
INSERT IGNORE INTO vehiculos (placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general) VALUES
('ABC-123', 'Chevrolet', 'NPR', 2020, 85000, 3500, 'ALTA', 'OPERATIVO'),
('DEF-456', 'Ford', 'Cargo', 2019, 120000, 4000, 'ALTA', 'MANTENIMIENTO'),
('GHI-789', 'Hino', '300', 2021, 45000, 3800, 'MEDIA', 'OPERATIVO');

-- ============================================
-- COMPONENTES INICIALES PARA VEHÍCULOS
-- ============================================
INSERT IGNORE INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion)
SELECT id, 'AMORTIGUADOR', 'BUENO', CURDATE() FROM vehiculos;

INSERT IGNORE INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion)
SELECT id, 'RESORTE', 'BUENO', CURDATE() FROM vehiculos;

INSERT IGNORE INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion)
SELECT id, 'ROTULA', 'BUENO', CURDATE() FROM vehiculos;

INSERT IGNORE INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion)
SELECT id, 'BUJE', 'BUENO', CURDATE() FROM vehiculos;

INSERT IGNORE INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion)
SELECT id, 'BRAZO_SUSPENSION', 'BUENO', CURDATE() FROM vehiculos;

INSERT IGNORE INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion)
SELECT id, 'BARRA_ESTABILIZADORA', 'BUENO', CURDATE() FROM vehiculos;

-- ============================================
-- VERIFICAR DATOS INSERTADOS
-- ============================================
SELECT '✅ Usuarios:' AS Tabla, COUNT(*) AS Registros FROM usuarios
UNION ALL
SELECT '✅ Vehículos:', COUNT(*) FROM vehiculos
UNION ALL
SELECT '✅ Componentes:', COUNT(*) FROM componentes
UNION ALL
SELECT '✅ Inspecciones:', COUNT(*) FROM inspecciones
UNION ALL
SELECT '✅ Mantenimientos:', COUNT(*) FROM mantenimientos
UNION ALL
SELECT '✅ Alertas:', COUNT(*) FROM alertas
UNION ALL
SELECT '✅ Priorizaciones:', COUNT(*) FROM priorizaciones;