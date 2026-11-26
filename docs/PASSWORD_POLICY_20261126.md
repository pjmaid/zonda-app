# Contraseñas de Zonda — 26 de noviembre de 2026

Versión 0.9.6. Los formularios de alta, recuperación, cambio obligatorio y
administración requieren un mínimo de 10 caracteres, con mayúscula, minúscula,
número y símbolo. La función administrativa aplica la misma validación.
Los espacios y las letras acentuadas no satisfacen el requisito de símbolo.
Se conserva el rechazo de las secuencias y palabras obvias ya bloqueadas.

La actualización no cambia contraseñas existentes ni aplica el nuevo requisito
al formulario de inicio de sesión. No se utilizaron contraseñas personales para
verificarla. `node --test tests/*.test.js`: 233 pruebas aprobadas.

La configuración central de Supabase Auth es independiente de esta validación:
todavía requiere comprobar `password_min_length=10` y los cuatro grupos de
caracteres en el panel o la API administrativa. Esa configuración no se pudo
consultar ni modificar con la conexión disponible. No se afirma que las llamadas
directas a Auth ya impongan la regla.

Las migraciones adicionales de auditoría, membresías y documentos se mantienen
fuera de esta publicación: la conexión SQL administrativa devuelve 28P01 y debe
restablecerse antes de aplicar el paquete que depende de ellas.
